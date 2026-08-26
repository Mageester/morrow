import { ChatStreamEnvelopeSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { conversationKeys } from "./conversations.js";
import { createEventSourceLifecycle, type EventStreamStatus } from "./event-stream.js";
import { taskQueryKey } from "./task-keys.js";

const eventTypes = [
  "message.updated",
  "tool.updated",
  "task.updated",
  "task.terminal",
] as const;

export type ChatTaskStreamStatus = EventStreamStatus;

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
    let reconcileTimer: number | null = null;
    let terminalRetryTimer: number | null = null;
    let terminalRetryAttempt = 0;
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
    const clearReconcileTimer = () => {
      if (reconcileTimer === null) return;
      window.clearTimeout(reconcileTimer);
      reconcileTimer = null;
    };
    const scheduleReconcile = (immediate = false) => {
      if (immediate) {
        clearReconcileTimer();
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
    const clearTerminalRetryTimer = () => {
      if (terminalRetryTimer === null) return;
      window.clearTimeout(terminalRetryTimer);
      terminalRetryTimer = null;
    };

    const completeTerminal = async () => {
      try {
        await reconcileTerminal();
        if (stopped) return;
        clearChatStreamCursor(identity);
        finished = true;
        terminalPending = false;
        setTerminal(true);
        lifecycle.close();
      } catch {
        if (stopped || finished) return;
        terminalPending = true;
        setStatus(navigator.onLine ? "reconnecting" : "offline");
        if (!navigator.onLine || terminalRetryTimer !== null) return;
        const delay = Math.min(1_000 * 2 ** terminalRetryAttempt, 15_000);
        terminalRetryAttempt += 1;
        terminalRetryTimer = window.setTimeout(() => {
          terminalRetryTimer = null;
          void completeTerminal();
        }, delay);
      }
    };

    const lifecycle = createEventSourceLifecycle({
      url: () => `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/stream?after=${cursor}`,
      eventTypes,
      onStatus: setStatus,
      canConnect: () => !finished && !terminalPending,
      shouldHandleOnline: () => !finished && terminalRetryTimer === null,
      onOpen: () => scheduleReconcile(true),
      onReconnect: () => { void reconcile(); },
      onOffline: () => {
        clearReconcileTimer();
        clearTerminalRetryTimer();
        void reconcile();
      },
      onOnline: () => {
        if (terminalPending) void completeTerminal();
      },
      // A backgrounded tab can silently stall an EventSource without firing
      // "error"; reconcile when it becomes visible again.
      onVisible: () => {
        if (finished) return;
        if (terminalPending) void completeTerminal();
        else void reconcile();
      },
      onEvent: (eventType, event, stream) => {
        try {
          const parsed = ChatStreamEnvelopeSchema.safeParse(
            JSON.parse(String(event.data)),
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
            stream.close();
            void completeTerminal();
            return;
          }
          scheduleReconcile(false);
        } catch {
          // Invalid or private stream data is ignored and never enters UI state.
        }
      },
    });
    lifecycle.start();
    if (terminalPending && navigator.onLine) void completeTerminal();

    return () => {
      stopped = true;
      clearReconcileTimer();
      clearTerminalRetryTimer();
      lifecycle.stop();
    };
  }, [conversationId, projectId, queryClient, taskId]);

  return { status, terminal } as const;
}
