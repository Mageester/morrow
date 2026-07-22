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

export function useChatTaskStream({ projectId, conversationId, taskId }: ChatTaskStreamIdentity) {
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
    let cursor = 0;

    const messagesKey = conversationKeys.messages(projectId, conversationId);
    const reconcile = () => queryClient.invalidateQueries({ queryKey: messagesKey });
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
      if (stopped || finished || source || reconnectTimer !== null) return;
      if (!navigator.onLine) {
        publishStatus("offline");
        return;
      }
      const url = `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(taskId)}/stream?after=${cursor}`;
      const active = new EventSource(url);
      source = active;
      active.addEventListener("open", () => {
        if (stopped || source !== active) return;
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
          if (stopped || source !== active || finished) return;
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
            void reconcile();
            if (eventType === "task.terminal") {
              finished = true;
              setTerminal(true);
              close();
            }
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
      connect();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    if (navigator.onLine) connect();

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
