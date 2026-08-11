import { ChatStreamEnvelopeSchema, ChatStreamHeartbeatSchema, TaskStatusSnapshotSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./client.js";
import { conversationKeys } from "./conversations.js";

const eventTypes = [
  "message.updated",
  "tool.updated",
  "task.updated",
  "task.terminal",
] as const;

export type ChatTaskStreamStatus =
  | "connecting"
  | "synchronized"
  | "reconnecting"
  | "offline";

export interface ChatTaskStreamIdentity {
  projectId: string;
  conversationId: string;
  taskId: string;
}

export interface ChatTaskStreamOptions {
  /** How often the silent-stream watchdog reconciles browser-safe snapshots. */
  reconcileIntervalMs?: number;
  /** How long a task stream may stay silent before a reconnect is attempted. */
  silenceTimeoutMs?: number;
  /** Base delay for bounded exponential reconnect backoff. */
  reconnectBaseDelayMs?: number;
  /** Maximum consecutive recovery attempts before staying offline. */
  maxReconnectAttempts?: number;
}

const CURSOR_PREFIX = "morrow.chat-stream-cursor.v1.";
const DEFAULT_RECONCILE_INTERVAL_MS = 5_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const TERMINAL_TASK_STATES = new Set(["completed", "verified", "failed", "cancelled", "interrupted"]);

export function chatStreamCursorKey({ projectId, conversationId, taskId }: ChatTaskStreamIdentity): string {
  return `${CURSOR_PREFIX}${encodeURIComponent(JSON.stringify([projectId, conversationId, taskId]))}`;
}

function readCursor(identity: ChatTaskStreamIdentity): { cursor: number; terminal: boolean } {
  try {
    const raw = sessionStorage.getItem(chatStreamCursorKey(identity));
    if (!raw) return { cursor: 0, terminal: false };
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" || value === null ||
      (value as { version?: unknown }).version !== 1 ||
      !Number.isSafeInteger((value as { cursor?: unknown }).cursor) ||
      Number((value as { cursor?: number }).cursor) < 0 ||
      typeof (value as { terminal?: unknown }).terminal !== "boolean"
    ) return { cursor: 0, terminal: false };
    return {
      cursor: Number((value as { cursor: number }).cursor),
      terminal: (value as { terminal: boolean }).terminal,
    };
  } catch {
    return { cursor: 0, terminal: false };
  }
}

function persistCursor(identity: ChatTaskStreamIdentity, cursor: number, terminal: boolean): void {
  try {
    sessionStorage.setItem(chatStreamCursorKey(identity), JSON.stringify({ version: 1, cursor, terminal }));
  } catch {
    // Stream recovery remains live in memory when browser storage is unavailable.
  }
}

export function resumeChatStreamAfter(identity: ChatTaskStreamIdentity, cursor: number): void {
  if (!Number.isSafeInteger(cursor) || cursor < 0) return;
  persistCursor(identity, cursor, false);
}

export function clearChatStreamCursor(identity: ChatTaskStreamIdentity): void {
  try { sessionStorage.removeItem(chatStreamCursorKey(identity)); } catch { /* no-op */ }
}

export function useChatTaskStream(identity: ChatTaskStreamIdentity, options: ChatTaskStreamOptions = {}) {
  const { projectId, conversationId, taskId } = identity;
  const queryClient = useQueryClient();
  const reconcileIntervalMs = Number.isFinite(options.reconcileIntervalMs) && (options.reconcileIntervalMs ?? 0) > 0
    ? options.reconcileIntervalMs!
    : DEFAULT_RECONCILE_INTERVAL_MS;
  const silenceTimeoutMs = Number.isFinite(options.silenceTimeoutMs) && (options.silenceTimeoutMs ?? 0) > 0
    ? options.silenceTimeoutMs!
    : DEFAULT_SILENCE_TIMEOUT_MS;
  const reconnectBaseDelayMs = Number.isFinite(options.reconnectBaseDelayMs) && (options.reconnectBaseDelayMs ?? 0) > 0
    ? options.reconnectBaseDelayMs!
    : DEFAULT_RECONNECT_BASE_DELAY_MS;
  const maxReconnectAttempts = Number.isSafeInteger(options.maxReconnectAttempts) && (options.maxReconnectAttempts ?? 0) > 0
    ? options.maxReconnectAttempts!
    : DEFAULT_MAX_RECONNECT_ATTEMPTS;
  const [status, setStatus] = useState<ChatTaskStreamStatus>(() =>
    navigator.onLine ? "connecting" : "offline",
  );
  const [terminal, setTerminal] = useState(false);

  useEffect(() => {
    let stopped = false;
    let finished = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let watchdogTimer: number | null = null;
    let reconnectAttempt = 0;
    let lastSignalAt = Date.now();
    let lastReconcileAt = 0;
    let checkingTask = false;
    const restored = readCursor(identity);
    let cursor = restored.cursor;
    let terminalPending = restored.terminal;

    const messagesKey = conversationKeys.messages(projectId, conversationId);
    const activityKey = conversationKeys.activity(projectId, conversationId);
    const reconcile = () => Promise.all([
      queryClient.invalidateQueries({ queryKey: messagesKey }),
      queryClient.invalidateQueries({ queryKey: activityKey }),
    ]);
    const reconcileTerminal = () => Promise.all([
      queryClient.refetchQueries(
        { queryKey: messagesKey, exact: true },
        { throwOnError: true },
      ),
      queryClient.refetchQueries(
        { queryKey: activityKey, exact: true, type: "active" },
        { throwOnError: true },
      ),
    ]);
    const clearTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };
    const clearWatchdog = () => {
      if (watchdogTimer === null) return;
      window.clearInterval(watchdogTimer);
      watchdogTimer = null;
    };
    const close = () => {
      const active = source;
      source = null;
      active?.close();
    };
    const publishStatus = (next: ChatTaskStreamStatus) => {
      if (!stopped) setStatus(next);
    };
    const markSignal = (resetRecoveryAttempts: boolean) => {
      lastSignalAt = Date.now();
      if (resetRecoveryAttempts) reconnectAttempt = 0;
    };
    const retryDelay = (attempt: number) => Math.min(reconnectBaseDelayMs * 2 ** attempt, 15_000);
    const readTaskStatus = () => api.get(
      `/api/tasks/${encodeURIComponent(taskId)}`,
      TaskStatusSnapshotSchema,
    );

    let connect: () => void;
    let scheduleReconnect: () => void;
    const completeTerminal = async () => {
      if (stopped || finished) return;
      try {
        const aggregate = await readTaskStatus();
        if (!TERMINAL_TASK_STATES.has(aggregate.task.status)) {
          terminalPending = false;
          persistCursor(identity, cursor, false);
          scheduleReconnect();
          return;
        }
        await reconcileTerminal();
        if (stopped) return;
        clearChatStreamCursor(identity);
        finished = true;
        terminalPending = false;
        setTerminal(true);
        close();
        clearTimer();
        clearWatchdog();
      } catch {
        if (stopped) return;
        terminalPending = true;
        publishStatus(navigator.onLine ? "reconnecting" : "offline");
        scheduleReconnect();
      }
    };
    scheduleReconnect = () => {
      if (stopped || finished || reconnectTimer !== null) return;
      if (!navigator.onLine) {
        publishStatus("offline");
        return;
      }
      if (reconnectAttempt >= maxReconnectAttempts) {
        publishStatus("offline");
        return;
      }
      publishStatus("reconnecting");
      const delay = retryDelay(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (terminalPending) void completeTerminal();
        else connect();
      }, delay);
    };
    const reconnect = () => {
      close();
      if (stopped || finished) return;
      void reconcile();
      if (!navigator.onLine) clearTimer();
      scheduleReconnect();
    };
    const reconcileAuthoritativeTask = async () => {
      if (stopped || finished || terminalPending || checkingTask) return;
      checkingTask = true;
      try {
        const aggregate = await readTaskStatus();
        if (stopped || finished || !TERMINAL_TASK_STATES.has(aggregate.task.status)) return;
        terminalPending = true;
        close();
        await completeTerminal();
      } catch {
        // The next bounded watchdog tick or reconnect will retry the read.
      } finally {
        checkingTask = false;
      }
    };

    connect = () => {
      if (stopped || finished || terminalPending || source || reconnectTimer !== null) return;
      if (!navigator.onLine) {
        publishStatus("offline");
        return;
      }
      const url = `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/stream?after=${cursor}`;
      const active = new EventSource(url);
      source = active;
      active.addEventListener("open", () => {
        if (stopped || source !== active || terminalPending) return;
        markSignal(false);
        publishStatus("synchronized");
        void reconcile();
      });
      active.addEventListener("error", () => {
        if (stopped || source !== active || finished) return;
        reconnect();
      });
      active.addEventListener("stream.heartbeat", (event) => {
        if (stopped || source !== active || finished || terminalPending) return;
        try {
          const parsed = ChatStreamHeartbeatSchema.safeParse(
            JSON.parse(String((event as MessageEvent).data)),
          );
          if (!parsed.success || parsed.data.conversationId !== conversationId || parsed.data.taskId !== taskId) return;
          markSignal(true);
          publishStatus("synchronized");
        } catch {
          // Invalid or private stream data is ignored and never enters UI state.
        }
      });
      for (const eventType of eventTypes) {
        active.addEventListener(eventType, (event) => {
          if (stopped || source !== active || finished || terminalPending) return;
          try {
            const parsed = ChatStreamEnvelopeSchema.safeParse(
              JSON.parse(String((event as MessageEvent).data)),
            );
            if (
              !parsed.success ||
              parsed.data.conversationId !== conversationId ||
              parsed.data.taskId !== taskId ||
              parsed.data.eventType !== eventType ||
              parsed.data.cursor <= cursor
            ) return;
            markSignal(true);
            cursor = parsed.data.cursor;
            persistCursor(identity, cursor, eventType === "task.terminal");
            if (eventType === "task.terminal") {
              terminalPending = true;
              close();
              void completeTerminal();
              return;
            }
            void reconcile();
          } catch {
            // Invalid or private stream data is ignored and never enters UI state.
          }
        });
      }
    };

    const offline = () => {
      clearTimer();
      close();
      publishStatus("offline");
      void reconcile();
    };
    const online = () => {
      if (stopped || finished || source || reconnectTimer !== null) return;
      reconnectAttempt = 0;
      publishStatus("reconnecting");
      if (terminalPending) void completeTerminal();
      else connect();
    };
    // A backgrounded browser tab can throttle or silently stall a live
    // EventSource without ever firing "error". The watchdog below handles the
    // same case while the tab remains visible; visibility remains a cheap
    // immediate reconciliation trigger.
    const visibility = () => {
      if (document.visibilityState !== "visible") return;
      if (stopped || finished) return;
      if (terminalPending) void completeTerminal();
      else {
        void reconcile();
        void reconcileAuthoritativeTask();
      }
    };
    const watchdog = () => {
      if (stopped || finished) return;
      const now = Date.now();
      if (now - lastReconcileAt >= reconcileIntervalMs) {
        lastReconcileAt = now;
        void reconcile();
        void reconcileAuthoritativeTask();
      }
      if (now - lastSignalAt >= silenceTimeoutMs && !terminalPending) reconnect();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visibility);
    watchdogTimer = window.setInterval(watchdog, Math.min(reconcileIntervalMs, silenceTimeoutMs));
    if (navigator.onLine) {
      if (terminalPending) void completeTerminal();
      else connect();
    }

    return () => {
      stopped = true;
      clearTimer();
      clearWatchdog();
      close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [conversationId, projectId, queryClient, taskId, maxReconnectAttempts, reconnectBaseDelayMs, reconcileIntervalMs, silenceTimeoutMs]);

  return { status, terminal } as const;
}
