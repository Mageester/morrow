import { ChatStreamEnvelopeSchema } from "@morrow/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
    const restored = readCursor(identity);
    let cursor = restored.cursor;
    let terminalPending = restored.terminal;

    const messagesKey = conversationKeys.messages(projectId, conversationId);
    const reconcile = () => queryClient.invalidateQueries({ queryKey: messagesKey });
    const reconcileTerminal = () => queryClient.refetchQueries(
      { queryKey: messagesKey, exact: true },
      { throwOnError: true },
    );
    const clearTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
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
        void reconcile();
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
      publishStatus("reconnecting");
      if (terminalPending) void completeTerminal();
      else connect();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
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
    };
  }, [conversationId, projectId, queryClient, taskId]);

  return { status, terminal } as const;
}
