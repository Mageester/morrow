import { ChatStreamEnvelopeSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { conversationKeys } from "./conversations.js";
import { taskQueryKey } from "./task-keys.js";

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

const CURSOR_PREFIX = "morrow.chat-stream-cursor.v1.";

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

export function useChatTaskStream(identity: ChatTaskStreamIdentity) {
  const { projectId, conversationId, taskId } = identity;
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ChatTaskStreamStatus>(() =>
    navigator.onLine ? "connecting" : "offline",
  );
  const [terminal, setTerminal] = useState(false);

  useEffect(() => {
    let stopped = false;
    let finished = false;
    let source: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;
    let reconcileTimer: number | null = null;
    const restored = readCursor(identity);
    let cursor = restored.cursor;
    let terminalPending = restored.terminal;

    const messagesKey = conversationKeys.messages(projectId, conversationId);
    const activityKey = conversationKeys.activity(projectId, conversationId);
    // Prefix, not exact: catches every per-task runtime query built from
    // taskQueryKey (context usage, capability/reasoning telemetry, …)
    // without this hook needing to know their individual suffixes. A query
    // that first resolved while the task was still queued or streaming
    // otherwise stays cached-empty for its whole staleTime — this is what
    // keeps the capability inspector from freezing on a stale "no request
    // yet" snapshot once the task actually completes.
    const taskKey = taskQueryKey(taskId);
    const reconcile = () => Promise.all([
      queryClient.invalidateQueries({ queryKey: messagesKey }),
      queryClient.invalidateQueries({ queryKey: activityKey }),
      queryClient.invalidateQueries({ queryKey: taskKey }),
    ]);
    const scheduleReconcile = (immediate = false) => {
      if (immediate) {
        if (reconcileTimer !== null) {
          window.clearTimeout(reconcileTimer);
          reconcileTimer = null;
        }
        void reconcile();
        return;
      }
      if (reconcileTimer !== null) return;
      reconcileTimer = window.setTimeout(() => {
        reconcileTimer = null;
        void reconcile();
      }, 50);
    };
    const reconcileTerminal = () => Promise.all([
      queryClient.refetchQueries(
        { queryKey: messagesKey, exact: true },
        { throwOnError: true },
      ),
      queryClient.refetchQueries(
        { queryKey: activityKey, exact: true, type: "active" },
        { throwOnError: true },
      ),
      // Best-effort: a runtime snapshot refresh must never block the message
      // reconciliation above, which the retry/backoff loop depends on.
      queryClient.invalidateQueries({ queryKey: taskKey }),
    ]);
    const clearTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (reconcileTimer !== null) {
        window.clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
    };
    const close = () => {
      const active = source;
      source = null;
      active?.close();
    };
    const publishStatus = (next: ChatTaskStreamStatus) => {
      if (!stopped) setStatus(next);
    };

    let connect: () => void;
    const completeTerminal = async () => {
      try {
        await reconcileTerminal();
        if (stopped) return;
        clearChatStreamCursor(identity);
        finished = true;
        terminalPending = false;
        setTerminal(true);
        close();
      } catch {
        if (stopped) return;
        terminalPending = true;
        publishStatus(navigator.onLine ? "reconnecting" : "offline");
        if (!navigator.onLine || reconnectTimer !== null) return;
        const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
        reconnectAttempt += 1;
        reconnectTimer = window.setTimeout(() => {
          reconnectTimer = null;
          void completeTerminal();
        }, delay);
      }
    };
    const reconnect = () => {
      close();
      if (stopped || finished) return;
      void reconcile();
      if (!navigator.onLine) {
        clearTimer();
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
        reconnectAttempt = 0;
        publishStatus("synchronized");
        scheduleReconcile(true);
      });
      active.addEventListener("error", () => {
        if (stopped || source !== active || finished) return;
        reconnect();
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
            cursor = parsed.data.cursor;
            persistCursor(identity, cursor, eventType === "task.terminal");
            if (eventType === "task.terminal") {
              terminalPending = true;
              close();
              void completeTerminal();
              return;
            }
            scheduleReconcile(false);
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
      publishStatus("reconnecting");
      if (terminalPending) void completeTerminal();
      else connect();
    };
    // A backgrounded browser tab can throttle or silently stall a live
    // EventSource without ever firing "error" — nothing else here would
    // notice, and refetchOnWindowFocus is deliberately off globally (see
    // app/providers.tsx), so there was no other safety net. Reconcile at
    // least once whenever the tab becomes visible again, unless the task is
    // already finished.
    const visibility = () => {
      if (document.visibilityState !== "visible") return;
      if (stopped || finished) return;
      if (terminalPending) void completeTerminal();
      else void reconcile();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visibility);
    if (navigator.onLine) {
      if (terminalPending) void completeTerminal();
      else connect();
    }

    return () => {
      stopped = true;
      clearTimer();
      close();
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [conversationId, projectId, queryClient, taskId]);

  return { status, terminal } as const;
}
