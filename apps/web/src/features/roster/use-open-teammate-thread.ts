import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { agentKeys } from "../../api/agents.js";
import { conversationApi, conversationKeys } from "../../api/conversations.js";

export interface OpenTeammateThread {
  /**
   * Open this teammate's thread: their most recent one when they have it,
   * otherwise a fresh conversation bound to them.
   */
  open: (teammate: { agentId: string | null; conversationId: string | null }) => void;
  /** The agent id currently being opened, so the row can show it is working. */
  openingAgentId: string | null | undefined;
  error: string | null;
}

/**
 * Selecting a teammate opens the thread with that teammate.
 *
 * A teammate with history goes straight to it — the rail is a way back into
 * work in progress, and starting a second empty thread every time you clicked
 * a name would bury it. A teammate with none gets a conversation created and
 * bound to them, so the very first message already runs under their policy
 * rather than the default assistant's.
 */
export function useOpenTeammateThread(projectId: string | undefined): OpenTeammateThread {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [openingAgentId, setOpeningAgentId] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // A synchronous guard: a double click must not create two conversations,
  // even before the state update that disables the row has propagated.
  const inFlight = useRef(false);

  function open(teammate: { agentId: string | null; conversationId: string | null }) {
    if (!projectId || inFlight.current) return;
    setError(null);

    if (teammate.conversationId) {
      void navigate({
        params: { conversationId: teammate.conversationId },
        search: { projectId },
        to: "/chats/$conversationId",
      });
      return;
    }

    inFlight.current = true;
    setOpeningAgentId(teammate.agentId);
    conversationApi
      .create(projectId, undefined, teammate.agentId ?? undefined)
      .then((conversation) => {
        void queryClient.invalidateQueries({ queryKey: agentKeys.roster(projectId) });
        void queryClient.invalidateQueries({ queryKey: conversationKeys.list(projectId, false) });
        return navigate({
          params: { conversationId: conversation.id },
          search: { projectId },
          to: "/chats/$conversationId",
        });
      })
      .catch(() => {
        setError("Morrow could not open that thread. Check the connection and try again.");
      })
      .finally(() => {
        inFlight.current = false;
        setOpeningAgentId(undefined);
      });
  }

  return { open, openingAgentId, error };
}
